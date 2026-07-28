#include<iostream>
#include<vector>
#include<algorithm>
#include<cstdlib>
using namespace std;
class Fraction{
   int x,y;
   public:
   Fraction(int a=0,int b=1):x(a),y(b){
   int g=std::__gcd(x<0?-x:x, y<0?-y:y);
   if(g!=0){ x/=g; y/=g; }
   }
         Fraction operator +( Fraction b)const{
                return  Fraction(x*b.y+y*b.x,y*b.y);
        }
         Fraction operator *( Fraction b)const{
                return  Fraction(x*b.x,y*b.y);
        }
         Fraction operator /(int b)const{
                return  Fraction(x,y*b);
        }
friend istream& operator>>(istream &is,Fraction &a);
friend ostream& operator<<(ostream &os,const Fraction &a);

};

istream& operator>>(istream &is,Fraction &a){
   char c;
   int p,q;
   is>>p>>c>>q;
   a=Fraction(p,q);
   return is;
}
ostream& operator<<(ostream &os,const Fraction &a){
   return os<<a.x<<"/"<<a.y;
}

class FVec{
   vector<Fraction>fv;
public:
        Fraction tol()const{
                Fraction ans=fv[0];
                for(int i=1;i<fv.size();i++){
                        ans=ans+fv[i];
                }
                return ans;
        }
        Fraction cross()const{
                Fraction ans=fv[0];
                for(int i=1;i<fv.size();i++){
                        ans=ans*fv[i];
                }
                return ans;
        }
        Fraction avg()const{
                return tol()/fv.size();
        }

friend istream& operator>>(istream &is,FVec &a);
friend ostream& operator<<(ostream &os,const FVec &a);

};

istream& operator>>(istream &is,FVec &a){
   int n;is>>n;
   for(int i=0;i<n;i++){Fraction f;is>>f;a.fv.push_back(f);}
   return is;
}
ostream& operator<<(ostream &os,const FVec &a){
   return os<<a.tol()<<endl<<a.cross()<<endl<<a.avg()<<endl;
}

int main(){
   FVec a;cin>>a;
   cout<<a;  //@ @guide uml:a
   return 0;
}
