#include<iostream>
#include<vector>
#include<numeric>
using namespace std;
class Score{
   double m_x,m_y;
   static int s_popu;//靜態成員變數
public:

   ~Score(){s_popu--;}
   Score(Score &b):m_x(b.m_x),m_y(b.m_y){s_popu++;}
   Score(double x=0,double y=1):m_x(x),m_y(y){s_popu++;}
   Score operator+(const Score& b)const{
   	  double ia=m_x*b.m_y+b.m_x*m_y;
   	  double ib=m_y*b.m_y;
   	  return Score(ia,ib);
   }
   Score operator-(const Score& b)const{
      double ia=m_x*b.m_y-b.m_x*m_y;
   	  double ib=m_y*b.m_y;
   	  return Score(ia,ib);
   }
   Score operator*(const Score& b)const{return Score(m_x*b.m_x,m_y*b.m_y);}
   Score operator/(const Score& b)const{return Score(m_x*b.m_y,m_y*b.m_x);}
   static int Population(){return s_popu;}
   friend istream& operator>>(istream &is,Score &a);
   friend ostream& operator<<(ostream &os,const Score&a);
};
int Score::s_popu;//靜態成員變數安排空間
istream& operator>>(istream &is,Score&a){
   is>>a.m_x;
   if(!is.fail()){
      double tmp;
      is>>tmp;
      if(!is.fail()) a.m_y=tmp;
   }
   return is;
}
ostream& operator<<(ostream &os,const Score&a){
   return os<<a.m_x<<"/"<<a.m_y;
}
class FVec:public vector<Score>{
   public:
   FVec(int n):vector<Score>(n){}
   Score sum()const{return accumulate(begin(),end(),Score());}
   Score avg()const{return sum()/size();}
};
istream& operator>>(istream &is,FVec&a){
   for(int k=0;k<a.size();k++)is>>a[k];
   return is;
}
ostream& operator<<(ostream &os,const FVec &a){
   return os<<"sum:"<<a.sum()<<endl<<"avg:"<<a.avg()<<endl;
}
int main(){
   {
   	int n;cin>>n;
	FVec pts(n);cin>>pts;
	cout<<pts<<endl;  //@ @guide uml:pts
	cout<<Score::Population()<<endl;
   }
   cout<<Score::Population()<<endl;
   return 0;
}
