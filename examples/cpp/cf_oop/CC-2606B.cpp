#include<iostream>
#include<vector>
#include<algorithm>
#include<cstdlib>
using namespace std;
class Frac{public:
  int m_x,m_y;
  Frac(int n=0,int d=1):m_x(n),m_y(d){
    int g=std::__gcd(m_x<0?-m_x:m_x, m_y<0?-m_y:m_y);
    if(g!=0){ m_x/=g; m_y/=g; }
  }
  Frac operator+(const Frac& b)const{
   	 return Frac(m_x*b.m_y+m_y*b.m_x, m_y*b.m_y);
  }
  Frac operator-(const Frac& b)const{
      return Frac(m_x*b.m_y-m_y*b.m_x, m_y*b.m_y);
  }
  Frac operator*(const Frac& b)const{return Frac(m_x*b.m_x, m_y*b.m_y);}
  Frac operator/(const Frac& b)const{return Frac(m_x*b.m_y, m_y*b.m_x);}
};
istream& operator>>(istream &xin,Frac &a){
  char c;
  return xin>>a.m_x>>c>>a.m_y;
}
ostream& operator<<(ostream &xout,const Frac &a){return xout<<a.m_x<<"/"<<a.m_y;}

int main(){
  Frac a,b;
  cin>>a>>b;
  cout<<a+b<<endl;  //@ @guide uml:a
  cout<<a-b<<endl;
  cout<<a*b<<endl;
  cout<<a/b<<endl;
  return 0;
}
